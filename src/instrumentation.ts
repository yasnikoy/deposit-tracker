export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startServer } = await import("./server/startup");
    try {
      await startServer();
    } catch (error) {
      console.error("Startup failed:", error);
      process.exit(1);
    }
  }
}
