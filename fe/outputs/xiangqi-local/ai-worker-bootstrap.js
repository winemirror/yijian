try {
  var assetVersion = self.location && self.location.search ? self.location.search : "";
  importScripts("ai-data.js" + assetVersion, "app.js" + assetVersion);
} catch (error) {
  self.postMessage({
    type: "bootstrap-error",
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : ""
  });
}
