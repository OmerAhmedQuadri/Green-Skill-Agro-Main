import { next } from '@gsa/eslint-config/next';
import { layers } from '@gsa/eslint-config/layers';

export default next({ tsconfigRootDir: import.meta.dirname, restrictedImports: layers.ui });
