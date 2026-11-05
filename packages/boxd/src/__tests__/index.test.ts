import { runProviderTestSuite } from '@computesdk/test-utils';
import { boxd } from '../index';

runProviderTestSuite({
  name: 'boxd',
  provider: boxd({}),
  supportsFilesystem: true,
  supportsStreaming: true,
  supportsProcesses: true,
  skipIntegration: !(process.env.BOXD_API_KEY || process.env.BOXD_TOKEN),
});
