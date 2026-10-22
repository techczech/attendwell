// Vite serves imported SVG files as URLs; this tells TypeScript the import's type.
declare module '*.svg'{const url:string;export default url}
