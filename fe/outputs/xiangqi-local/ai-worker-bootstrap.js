try {
  importScripts("ai-data.js", "app.js");
} catch (error) {
  self.postMessage({
    type: "bootstrap-error",
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : ""
  });
}
