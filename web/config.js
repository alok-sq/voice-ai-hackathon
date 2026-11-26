// Runtime config for the console. No secrets here: the backend holds all API keys.
// Leave `backendUrl` empty to run in demo mode (a simulated call, no keys needed).
window.VOICE_CONSOLE_CONFIG = {
  backendUrl: "",            // e.g. "http://localhost:8000" once the backend is running
  livekitClientSrc: "https://cdn.jsdelivr.net/npm/livekit-client@2.5.0/dist/livekit-client.umd.min.js",
  eventsTopic: "call-events" // LiveKit data-message topic the agent publishes on
};
