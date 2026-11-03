package tv

import (
	"strconv"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newTestMixes(t *testing.T) *Mixes {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return NewMixes(rdb)
}

func TestMixDefaultsToFullMediaAndNobodyChanged(t *testing.T) {
	mixes := newTestMixes(t)

	mix, err := mixes.Get(t.Context(), "d1")

	require.NoError(t, err)
	require.Equal(t, Mix{Media: 1, People: map[string]float64{}}, mix)
}

func TestMixIsKeptPerDevice(t *testing.T) {
	mixes := newTestMixes(t)
	ctx := t.Context()
	want := Mix{Media: 0.5, People: map[string]float64{"m1": 0}}

	require.NoError(t, mixes.Set(ctx, "d1", want))
	got, err := mixes.Get(ctx, "d1")
	require.NoError(t, err)
	require.Equal(t, want, got)

	require.NoError(t, mixes.Drop(ctx, "d1"))
	got, err = mixes.Get(ctx, "d1")
	require.NoError(t, err)
	require.Equal(t, 1.0, got.Media)
}

func TestMixValid(t *testing.T) {
	many := map[string]float64{}
	for i := range MaxMixPeople + 1 {
		many["m"+strconv.Itoa(i)] = 1
	}
	tests := []struct {
		name string
		mix  Mix
		ok   bool
	}{
		{name: "volumes entre 0 e 1 passam", mix: Mix{Media: 0, People: map[string]float64{"m1": 1, "m2": 0.3}}, ok: true},
		{name: "sem pessoas passa", mix: Mix{Media: 1}, ok: true},
		{name: "mídia acima de 1 é recusada", mix: Mix{Media: 1.5}, ok: false},
		{name: "pessoa negativa é recusada", mix: Mix{Media: 1, People: map[string]float64{"m1": -0.1}}, ok: false},
		{name: "chave vazia é recusada", mix: Mix{Media: 1, People: map[string]float64{"": 1}}, ok: false},
		{name: "chave longa demais é recusada", mix: Mix{Media: 1, People: map[string]float64{strings.Repeat("m", maxMixKeyBytes+1): 1}}, ok: false},
		{name: "gente demais é recusada", mix: Mix{Media: 1, People: many}, ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.ok, tt.mix.Valid())
		})
	}
}
