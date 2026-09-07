import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';

register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
