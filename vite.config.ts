import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {readFileSync} from 'node:fs';
const version=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
// Relative asset URLs: the same build loads at /, /check-in and any configured public /<prefix>/.
export default defineConfig({base:'./',plugins:[tailwindcss()],define:{__APP_VERSION__:JSON.stringify(version)},build:{sourcemap:false}});
