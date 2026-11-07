package extension

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// The vector the Worker checks too: both sides must land on the same subdomain.
func TestSubForIsTheSharedVector(t *testing.T) {
	require.Equal(t, "lczfxd2q74zxknb5", SubFor("exemplo"))
}

func validManifest() map[string]any {
	return map[string]any{
		"id": "exemplo", "name": "Exemplo", "version": "1.0.0", "protocol": 1, "entry": "index.html",
		"hosts": map[string]any{
			"connect": []string{"api.exemplo.com", "hcaptcha.com"},
			"images":  []string{"img.exemplo.com"},
			"media":   []string{"*.cdn.exemplo.com"},
		},
		"captcha": "hcaptcha",
	}
}

func encode(t *testing.T, m map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(m)
	require.NoError(t, err)
	return raw
}

func hosts(m map[string]any) map[string]any { return m["hosts"].(map[string]any) }

func TestParseManifestAcceptsAValidOne(t *testing.T) {
	m, err := ParseManifest(encode(t, validManifest()))
	require.NoError(t, err)
	require.Equal(t, "exemplo", m.ID)
	require.Equal(t, "index.html", m.Entry)
	require.Equal(t, []string{"*.cdn.exemplo.com"}, m.Hosts.Media)
	require.Equal(t, "hcaptcha", m.Captcha)
}

func TestParseManifestRefuses(t *testing.T) {
	many := make([]string, 17)
	for i := range many {
		many[i] = fmt.Sprintf("h%d.example.com", i)
	}
	tests := map[string]func(m map[string]any){
		"id curto":                  func(m map[string]any) { m["id"] = "ab" },
		"id maiúsculo":              func(m map[string]any) { m["id"] = "Exemplo" },
		"id começando com número":   func(m map[string]any) { m["id"] = "1exemplo" },
		"id com 33 caracteres":      func(m map[string]any) { m["id"] = "abcdefghijklmnopqrstuvwxyz0123456" },
		"id reservado":              func(m map[string]any) { m["id"] = "host" },
		"sem nome":                  func(m map[string]any) { m["name"] = "" },
		"protocolo 2":               func(m map[string]any) { m["protocol"] = 2 },
		"sem protocolo":             func(m map[string]any) { delete(m, "protocol") },
		"host com esquema":          func(m map[string]any) { hosts(m)["connect"] = []string{"https://a.com"} },
		"host com porta":            func(m map[string]any) { hosts(m)["connect"] = []string{"a.com:443"} },
		"host IPv4":                 func(m map[string]any) { hosts(m)["images"] = []string{"10.0.0.1"} },
		"host IPv6":                 func(m map[string]any) { hosts(m)["images"] = []string{"[::1]"} },
		"localhost":                 func(m map[string]any) { hosts(m)["connect"] = []string{"localhost"} },
		"subdomínio de localhost":   func(m map[string]any) { hosts(m)["connect"] = []string{"x.localhost"} },
		"host maiúsculo":            func(m map[string]any) { hosts(m)["connect"] = []string{"A.com"} },
		"host com caminho":          func(m map[string]any) { hosts(m)["connect"] = []string{"a.com/x"} },
		"host sem ponto":            func(m map[string]any) { hosts(m)["connect"] = []string{"intranet"} },
		"curinga em connect":        func(m map[string]any) { hosts(m)["connect"] = []string{"*.a.com"} },
		"curinga em images":         func(m map[string]any) { hosts(m)["images"] = []string{"*.a.com"} },
		"qualquer host com outro":   func(m map[string]any) { hosts(m)["media"] = []string{"*", "a.com"} },
		"curinga de TLD em media":   func(m map[string]any) { hosts(m)["media"] = []string{"*.com"} },
		"curinga no meio em media":  func(m map[string]any) { hosts(m)["media"] = []string{"a.*.com"} },
		"mais de 16 hosts":          func(m map[string]any) { hosts(m)["connect"] = many },
		"entry com ..":              func(m map[string]any) { m["entry"] = "../index.html" },
		"entry com .. no meio":      func(m map[string]any) { m["entry"] = "a/../../index.html" },
		"entry absoluto":            func(m map[string]any) { m["entry"] = "/index.html" },
		"entry com URL":             func(m map[string]any) { m["entry"] = "https://evil.com/x.html" },
		"entry com barra invertida": func(m map[string]any) { m["entry"] = `a\index.html` },
		"sem entry":                 func(m map[string]any) { m["entry"] = "" },
		"entry que não é html":      func(m map[string]any) { m["entry"] = "index.js" },
		"entry em pasta oculta":     func(m map[string]any) { m["entry"] = ".x/index.html" },
		"entry com espaço":          func(m map[string]any) { m["entry"] = "a b.html" },
		"entry com segmento vazio":  func(m map[string]any) { m["entry"] = "a//index.html" },
		"ícone com ..":              func(m map[string]any) { m["icon"] = "../icon.png" },
		"ícone não imagem":          func(m map[string]any) { m["icon"] = "icon.js" },
		"captcha desconhecido":      func(m map[string]any) { m["captcha"] = "recaptcha" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			m := validManifest()
			mutate(m)
			_, err := ParseManifest(encode(t, m))
			require.Error(t, err)
		})
	}
}

func TestParseManifestTurnsMissingHostListsIntoEmptyOnes(t *testing.T) {
	m := validManifest()
	m["hosts"] = map[string]any{"connect": []string{"api.kiwi.com"}}
	parsed, err := ParseManifest(encode(t, m))
	require.NoError(t, err)

	raw, err := json.Marshal(parsed.Hosts)
	require.NoError(t, err)
	require.JSONEq(t, `{"connect":["api.kiwi.com"],"images":[],"media":[]}`, string(raw))
}

func TestParseManifestRefusesSomethingThatIsNotJSON(t *testing.T) {
	_, err := ParseManifest([]byte("<html>"))
	require.Error(t, err)
}

// manifestCases is extensions/manifest-cases.json: the one table of what a
// juntos.json may be, which the extension host and the page check too.
type manifestCases struct {
	Base   map[string]any `json:"base"`
	Accept []struct {
		Case   string         `json:"case"`
		Set    map[string]any `json:"set"`
		Unset  []string       `json:"unset"`
		Expect map[string]any `json:"expect"`
	} `json:"accept"`
	Refuse []struct {
		Case    string         `json:"case"`
		Set     map[string]any `json:"set"`
		Replace any            `json:"replace"`
	} `json:"refuse"`
}

func loadManifestCases(t *testing.T) manifestCases {
	t.Helper()
	raw, err := os.ReadFile("../../extensions/manifest-cases.json")
	require.NoError(t, err)
	var cases manifestCases
	require.NoError(t, json.Unmarshal(raw, &cases))
	return cases
}

func withCase(base map[string]any, set map[string]any, unset []string) map[string]any {
	m := maps.Clone(base)
	maps.Copy(m, set)
	for _, key := range unset {
		delete(m, key)
	}
	return m
}

func TestParseManifestFollowsTheSharedTable(t *testing.T) {
	cases := loadManifestCases(t)
	for _, c := range cases.Accept {
		t.Run("aceita "+c.Case, func(t *testing.T) {
			m, err := ParseManifest(encode(t, withCase(cases.Base, c.Set, c.Unset)))
			require.NoError(t, err)
			got := map[string]any{"name": m.Name, "hosts": map[string]any{"connect": m.Hosts.Connect, "images": m.Hosts.Images, "media": m.Hosts.Media}}
			if m.Icon != "" {
				got["icon"] = m.Icon
			}
			if m.Captcha != "" {
				got["captcha"] = m.Captcha
			}
			for key, want := range c.Expect {
				wantJSON, _ := json.Marshal(want)
				gotJSON, _ := json.Marshal(got[key])
				require.JSONEq(t, string(wantJSON), string(gotJSON), key)
			}
		})
	}
	for _, c := range cases.Refuse {
		t.Run("recusa "+c.Case, func(t *testing.T) {
			var raw []byte
			if c.Replace != nil {
				raw, _ = json.Marshal(c.Replace)
			} else {
				raw = encode(t, withCase(cases.Base, c.Set, nil))
			}
			_, err := ParseManifest(raw)
			require.ErrorIs(t, err, ErrBadManifest)
		})
	}
}
