class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResult {
  constructor(content) {
    this.content = content;
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
  }
}

class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}

module.exports = {
  LanguageModelTextPart,
  LanguageModelToolResultPart,
  LanguageModelToolCallPart,
  LanguageModelToolResult,
  MarkdownString,
  EventEmitter,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    getConfiguration() {
      return {
        get(_key, defaultValue) {
          return defaultValue;
        },
      };
    },
  },
  lm: {
    registerTool() {
      return { dispose() {} };
    },
  },
};
