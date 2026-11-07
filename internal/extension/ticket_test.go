package extension

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The host Worker's test checks the same vector (extensions/host/test/ticket.test.ts).
func TestMediaTicketVector(t *testing.T) {
	got := MediaTicket([]byte("chave-de-teste"), "pbosap5oxsmmteeo", "https://cdn.exemplo.dev/a.m3u8", time.Unix(1794100000, 0))
	require.Equal(t, mediaTicketVector, got)
}

func TestMediaTicketBindsEveryPart(t *testing.T) {
	key := []byte("k")
	at := time.Unix(1794100000, 0)
	base := MediaTicket(key, "aaaaaaaaaaaaaaaa", "https://a.dev/x", at)
	require.NotEqual(t, base, MediaTicket([]byte("k2"), "aaaaaaaaaaaaaaaa", "https://a.dev/x", at))
	require.NotEqual(t, base, MediaTicket(key, "bbbbbbbbbbbbbbbb", "https://a.dev/x", at))
	require.NotEqual(t, base, MediaTicket(key, "aaaaaaaaaaaaaaaa", "https://a.dev/y", at))
	require.NotEqual(t, base, MediaTicket(key, "aaaaaaaaaaaaaaaa", "https://a.dev/x", at.Add(time.Second)))
}

const mediaTicketVector = "1794100000.EXqQumSlBlPyRZ7yfJlLVsEwEvCBkZWh_pInmzZ9Bgs"
