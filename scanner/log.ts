export function k6log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
