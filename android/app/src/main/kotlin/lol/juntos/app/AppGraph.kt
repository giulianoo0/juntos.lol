package lol.juntos.app

import lol.juntos.core.api.JuntosApi
import lol.juntos.core.fake.FakeJuntosApi
import lol.juntos.core.fake.FakeSyncSessionFactory
import lol.juntos.core.human.HumanGate
import lol.juntos.core.sync.SyncSessionFactory
import lol.juntos.player.FakePlayer
import lol.juntos.player.PlayerFactory
import lol.juntos.update.NoUpdater
import lol.juntos.update.Updater

/** Everything the screens talk to. The integration swaps the fakes for the real pieces. */
interface AppGraph {
    val baseUrl: String
    val api: JuntosApi
    val sessions: SyncSessionFactory
    val players: PlayerFactory
    val updater: Updater
    val human: HumanGate
}

class FakeAppGraph(override val baseUrl: String = BuildConfig.BASE_URL) : AppGraph {
    override val api: JuntosApi = FakeJuntosApi()
    override val sessions: SyncSessionFactory = FakeSyncSessionFactory()
    override val players: PlayerFactory = PlayerFactory { FakePlayer() }
    override val updater: Updater = NoUpdater()
    override val human: HumanGate = HumanGate { true }
}
