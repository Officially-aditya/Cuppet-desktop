import { OpenAICompatibleChatProvider } from './provider.mjs';
import { createNativeProvider, nativeProviderKind } from './native-provider.mjs';

export function createChatProvider(configuration = {}) {
  return createNativeProvider(configuration) ?? new OpenAICompatibleChatProvider(configuration);
}

export { nativeProviderKind };
