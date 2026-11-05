import { runProviderCrudTest } from '@computesdk/test-utils';
import { boxd } from '../index';

runProviderCrudTest({
  name: 'boxd',
  provider: boxd({}),
  skipIntegration: !(process.env.BOXD_API_KEY || process.env.BOXD_TOKEN),
  timeout: 90_000,
});
