# packages/host/recovery

Host 侧 `nuke-third-party` 恢复原语：基线白名单、profile fixture 上的 remove/保留、loopback 受信通道。

实现：

- [`../../src/recovery/baseline.ts`](../../src/recovery/baseline.ts)
- [`../../src/recovery/nuke-third-party.ts`](../../src/recovery/nuke-third-party.ts)
- [`../../src/recovery/loopback-auth.ts`](../../src/recovery/loopback-auth.ts)
- [`../../src/recovery/host.ts`](../../src/recovery/host.ts)
- CLI：[`../../src/recovery/cli.ts`](../../src/recovery/cli.ts)

运维说明见 [`../../docs/recovery.md`](../../docs/recovery.md)。
