import { AcpProviderAdapter } from './acp.mjs';

// Compatibility export while callers migrate to the protocol-level ACP adapter.
// OpenCode is a backend descriptor, not its own runtime architecture.
export class OpenCodeAcpProviderV2 extends AcpProviderAdapter {
  constructor(configuration = {}) {
    super({ providerID: 'opencode', ...configuration });
  }
}
