package extension

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrBadRepo       = errors.New("bad repo")
	ErrRepoNotFound  = errors.New("repo not found")
	ErrNotOpenSource = errors.New("repo is private or has no license")

	ownerPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,38}$`)
	repoPattern  = regexp.MustCompile(`^[a-z0-9._-]{1,100}$`)
	shaPattern   = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

const (
	maxManifestBytes = 64 << 10
	githubTimeout    = 10 * time.Second
	// headTTL is how long a repository's HEAD is reused. Without a token the
	// GitHub API allows 60 calls an hour per IP, and every extension the site
	// or the extension host opens asks for its HEAD.
	headTTL = 30 * time.Second
)

// ParseRepo reads "owner/repo", lowercased: GitHub does not tell them apart
// by case, so neither may the registry.
func ParseRepo(raw string) (string, error) {
	owner, name, ok := strings.Cut(strings.ToLower(strings.TrimSpace(raw)), "/")
	if !ok || !ownerPattern.MatchString(owner) || !repoPattern.MatchString(name) || name == "." || name == ".." {
		return "", ErrBadRepo
	}
	return owner + "/" + name, nil
}

// GitHub reads an extension's juntos.json from its repository.
type GitHub struct {
	APIBase string
	RawBase string
	// Token, when set, goes to the API (not to raw files) and lifts its rate limit.
	Token  string
	Client *http.Client
	Now    func() time.Time

	mu    sync.Mutex
	heads map[string]cachedHead
}

type cachedHead struct {
	sha string
	at  time.Time
}

// NewGitHub reads from the API and raw bases given, github.com's or a local
// stand-in.
func NewGitHub(apiBase, rawBase, token string) *GitHub {
	return &GitHub{APIBase: apiBase, RawBase: rawBase, Token: token, Client: &http.Client{Timeout: githubTimeout}}
}

func (g *GitHub) get(ctx context.Context, url, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if g.Token != "" && strings.HasPrefix(url, g.APIBase+"/") {
		req.Header.Set("Authorization", "Bearer "+g.Token)
	}
	req.Header.Set("User-Agent", "juntos-extensions")
	return g.Client.Do(req)
}

func (g *GitHub) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// Head is the sha of the repository's default branch, read again from
// GitHub at most every headTTL.
func (g *GitHub) Head(ctx context.Context, repo string) (string, error) {
	g.mu.Lock()
	hit, ok := g.heads[repo]
	g.mu.Unlock()
	if ok && g.now().Sub(hit.at) < headTTL {
		return hit.sha, nil
	}
	sha, err := g.head(ctx, repo)
	if err != nil {
		return "", err
	}
	g.mu.Lock()
	if g.heads == nil {
		g.heads = map[string]cachedHead{}
	}
	g.heads[repo] = cachedHead{sha: sha, at: g.now()}
	g.mu.Unlock()
	return sha, nil
}

func (g *GitHub) head(ctx context.Context, repo string) (string, error) {
	resp, err := g.get(ctx, g.APIBase+"/repos/"+repo+"/commits/HEAD", "application/vnd.github.sha")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusUnprocessableEntity {
		return "", ErrRepoNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github head: %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 128))
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(body))
	if !shaPattern.MatchString(sha) {
		return "", fmt.Errorf("github head: not a sha")
	}
	return sha, nil
}

// CheckOpenSource refuses with ErrNotOpenSource a repository that is not
// public or that GitHub finds no license in.
func (g *GitHub) CheckOpenSource(ctx context.Context, repo string) error {
	resp, err := g.get(ctx, g.APIBase+"/repos/"+repo, "application/vnd.github+json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrRepoNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("github repo: %s", resp.Status)
	}
	var meta struct {
		Private *bool           `json:"private"`
		License json.RawMessage `json:"license"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxManifestBytes)).Decode(&meta); err != nil {
		return fmt.Errorf("github repo: %w", err)
	}
	if meta.Private == nil || *meta.Private || len(meta.License) == 0 || string(meta.License) == "null" {
		return ErrNotOpenSource
	}
	return nil
}

// Manifest is the validated juntos.json of the repository at sha.
func (g *GitHub) Manifest(ctx context.Context, repo, sha string) (Manifest, error) {
	if !shaPattern.MatchString(sha) {
		return Manifest{}, fmt.Errorf("manifest: not a sha")
	}
	resp, err := g.get(ctx, g.RawBase+"/"+repo+"/"+sha+"/juntos.json", "")
	if err != nil {
		return Manifest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Manifest{}, badManifest("juntos.json missing")
	}
	if resp.StatusCode != http.StatusOK {
		return Manifest{}, fmt.Errorf("github raw: %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes+1))
	if err != nil {
		return Manifest{}, err
	}
	if len(body) > maxManifestBytes {
		return Manifest{}, badManifest("over %d bytes", maxManifestBytes)
	}
	return ParseManifest(body)
}
