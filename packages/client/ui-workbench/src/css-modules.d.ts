/** CSS Modules ambient types (the tsdown bundle compiles them to hashed class maps). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
