// electron-vite: `import file from './x.png?asset'` copies the file next to the bundle and
// resolves to its absolute path at runtime.
declare module '*?asset' {
  const path: string
  export default path
}
