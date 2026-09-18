import { base } from '@gsa/eslint-config/base';
import { layers } from '@gsa/eslint-config/layers';

export default base({ tsconfigRootDir: import.meta.dirname, restrictedImports: layers.config });
