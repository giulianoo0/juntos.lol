package room

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUnlistedMemberHidesItsAccount(t *testing.T) {
	listed, err := json.Marshal(Member{ID: "m1", AccountID: 7, Avatar: "fox"})
	require.NoError(t, err)
	require.Contains(t, string(listed), `"accountId":7`)

	unlisted, err := json.Marshal(Member{ID: "m2", AccountID: 7, Avatar: "fox", Unlisted: true})
	require.NoError(t, err)
	require.NotContains(t, string(unlisted), "accountId")
	require.Contains(t, string(unlisted), `"avatar":"fox"`)
}
