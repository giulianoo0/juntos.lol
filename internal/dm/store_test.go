package dm

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/db/dbtest"
)

func publicKey(t *testing.T) string {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	require.NoError(t, err)
	return base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes())
}

func b64(n int) string {
	raw := make([]byte, n)
	_, _ = rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func wrapped() WrappedKey { return WrappedKey{IV: b64(12), Key: b64(48)} }

type fixture struct {
	store      *Store
	ana, bia   int64
	anaPhone   Device
	anaLaptop  Device
	biaBrowser Device
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := dbtest.New(t)
	accounts := account.NewStore(pool)
	ctx := t.Context()
	ana, err := accounts.SignInDiscord(ctx, account.DiscordUser{ID: "1", GlobalName: "Ana"})
	require.NoError(t, err)
	bia, err := accounts.SignInDiscord(ctx, account.DiscordUser{ID: "2", GlobalName: "Bia"})
	require.NoError(t, err)
	store := NewStore(pool)
	f := fixture{store: store, ana: ana.ID, bia: bia.ID}
	f.anaPhone, err = store.RegisterDevice(ctx, ana.ID, publicKey(t), "Celular")
	require.NoError(t, err)
	f.anaLaptop, err = store.RegisterDevice(ctx, ana.ID, publicKey(t), "Notebook")
	require.NoError(t, err)
	f.biaBrowser, err = store.RegisterDevice(ctx, bia.ID, publicKey(t), "")
	require.NoError(t, err)
	return f
}

func (f fixture) message(clientID string) Outgoing {
	return Outgoing{
		From: f.ana, To: f.bia, SenderDevice: f.anaPhone.ID, ClientID: clientID, IV: b64(12), Body: b64(40),
		Keys: map[string]WrappedKey{f.anaPhone.ID: wrapped(), f.anaLaptop.ID: wrapped(), f.biaBrowser.ID: wrapped()},
	}
}

func TestEachDeviceReadsOnlyItsOwnWrappedKey(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	out := f.message("client-0001")
	sent, err := f.store.Send(ctx, out)
	require.NoError(t, err)

	page, err := f.store.Page(ctx, f.bia, f.ana, f.biaBrowser.ID, 0, 0)
	require.NoError(t, err)
	require.Len(t, page, 1)
	require.Equal(t, sent.ID, page[0].ID)
	require.Equal(t, f.bia, page[0].To)
	require.Equal(t, out.Keys[f.biaBrowser.ID], *page[0].Key)

	mine, err := f.store.Page(ctx, f.ana, f.bia, f.anaLaptop.ID, 0, 0)
	require.NoError(t, err)
	require.Equal(t, out.Keys[f.anaLaptop.ID], *mine[0].Key, "o outro aparelho de quem mandou também lê")
}

func TestSendRefusesKeysThatMissADeviceAndNamesTheCurrentOnes(t *testing.T) {
	f := setup(t)
	out := f.message("client-0002")
	delete(out.Keys, f.anaLaptop.ID)

	_, err := f.store.Send(t.Context(), out)
	var stale *StaleDevicesError
	require.True(t, errors.As(err, &stale))
	require.Len(t, stale.Devices[f.ana], 2)
	require.Len(t, stale.Devices[f.bia], 1)
}

func TestSendingTheSameClientIDTwiceKeepsOneMessage(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	first, err := f.store.Send(ctx, f.message("client-0003"))
	require.NoError(t, err)
	again, err := f.store.Send(ctx, f.message("client-0003"))
	require.NoError(t, err)
	require.Equal(t, first.ID, again.ID)
	page, err := f.store.Page(ctx, f.ana, f.bia, f.anaPhone.ID, 0, 0)
	require.NoError(t, err)
	require.Len(t, page, 1)
}

func TestSendFromADeviceOfAnotherAccountIsRefused(t *testing.T) {
	f := setup(t)
	out := f.message("client-0004")
	out.SenderDevice = f.biaBrowser.ID
	_, err := f.store.Send(t.Context(), out)
	require.ErrorIs(t, err, ErrNoDevice)
}

func TestThreadsCountUnreadUntilMarkedRead(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	var last Message
	for _, id := range []string{"client-0010", "client-0011"} {
		var err error
		last, err = f.store.Send(ctx, f.message(id))
		require.NoError(t, err)
	}
	threads, err := f.store.Threads(ctx, f.bia, f.biaBrowser.ID)
	require.NoError(t, err)
	require.Len(t, threads, 1)
	require.Equal(t, f.ana, threads[0].Other)
	require.Equal(t, 2, threads[0].Unread)
	require.Equal(t, last.ID, threads[0].Last.ID)

	_, err = f.store.MarkRead(ctx, f.bia, f.ana, last.ID)
	require.NoError(t, err)
	kept, err := f.store.MarkRead(ctx, f.bia, f.ana, 1)
	require.NoError(t, err)
	require.Equal(t, last.ID, kept, "lido nunca volta atrás")
	threads, err = f.store.Threads(ctx, f.bia, f.biaBrowser.ID)
	require.NoError(t, err)
	require.Zero(t, threads[0].Unread)

	sender, err := f.store.Threads(ctx, f.ana, f.anaPhone.ID)
	require.NoError(t, err)
	require.Equal(t, last.ID, sender[0].TheyRead)
	require.Zero(t, sender[0].Unread, "as próprias mensagens não contam como não lidas")
}

func TestRegisteringTheSameKeyAgainIsTheSameDeviceAndOldDevicesFallOff(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	again, err := f.store.RegisterDevice(ctx, f.ana, f.anaPhone.PublicKey, "outro nome")
	require.NoError(t, err)
	require.Equal(t, f.anaPhone.ID, again.ID)

	for range MaxDevices {
		_, err := f.store.RegisterDevice(ctx, f.bia, publicKey(t), "")
		require.NoError(t, err)
	}
	devices, err := f.store.Devices(ctx, f.bia)
	require.NoError(t, err)
	require.Len(t, devices[f.bia], MaxDevices)
	for _, d := range devices[f.bia] {
		require.NotEqual(t, f.biaBrowser.ID, d.ID, "o aparelho visto há mais tempo sai")
	}
}

func TestOnlyP256PointsAreKeys(t *testing.T) {
	require.True(t, ValidPublicKey(publicKey(t)))
	require.False(t, ValidPublicKey(b64(65)))
	require.False(t, ValidPublicKey(strings.Repeat("A", 87)))
	_, err := setup(t).store.RegisterDevice(t.Context(), 1, b64(65), "")
	require.ErrorIs(t, err, ErrInvalid)
}

func TestSinceIsWhatADeviceMissedInOrder(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	first, err := f.store.Send(ctx, f.message("client-0020"))
	require.NoError(t, err)
	second, err := f.store.Send(ctx, f.message("client-0021"))
	require.NoError(t, err)
	missed, err := f.store.Since(ctx, f.bia, f.biaBrowser.ID, first.ID)
	require.NoError(t, err)
	require.Len(t, missed, 1)
	require.Equal(t, second.ID, missed[0].ID)
}
