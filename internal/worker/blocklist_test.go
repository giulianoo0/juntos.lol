package worker

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBlocklist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "block.txt")
	require.NoError(t, os.WriteFile(path, []byte("# comment\n\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nForbidden Title\n"), 0o600))
	b, err := LoadBlocklist(path)
	require.NoError(t, err)
	require.Equal(t, 2, b.Len())
	require.True(t, b.Rejects("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ""))
	require.True(t, b.Rejects("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "the.forbidden.title.2024"))
	require.False(t, b.Rejects("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "fine"))
	require.False(t, b.Rejects("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ""))

	empty, err := LoadBlocklist("")
	require.NoError(t, err)
	require.False(t, empty.Rejects("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "x"))
	var nilList *Blocklist
	require.False(t, nilList.Rejects("x", "y"))
}
