// VibeAI page settings. The model and API key live on the server in api/config.php.
window.VIBE_CONFIG = {
  // Max characters the user can type in one message.
  MAX_INPUT_CHARS: 2000,

  // How many recent messages the page sends along for context (server trims again).
  MAX_CONTEXT_MESSAGES: 20,

  // Optional shortcut buttons. They only fill the message and send it to the AI.
  SUGGESTIONS: [
    "Give me three fun weekend ideas at home",
    "Suggest a movie for a rainy night",
    "Help me think of a name for a pet cat",
    "Explain how rainbows form like I'm ten"
  ]
};
