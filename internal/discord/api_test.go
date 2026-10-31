package discord

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsGuildMember(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		member bool
		fails  bool
	}{
		{name: "quem está no servidor é membro", status: http.StatusOK, body: `{"roles":[]}`, member: true},
		{name: "membro desconhecido não é membro", status: http.StatusNotFound, body: `{"message":"Unknown Member","code":10007}`},
		{name: "bot fora do servidor é erro, não um não", status: http.StatusNotFound, body: `{"message":"Unknown Guild","code":10004}`, fails: true},
		{name: "404 sem código é erro", status: http.StatusNotFound, body: `404 page not found`, fails: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			api := &API{Base: server.URL, BotToken: "bot", Client: server.Client()}

			member, err := api.IsGuildMember(t.Context(), "G1", "U1")

			require.Equal(t, tt.member, member)
			if tt.fails {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
		})
	}
}
