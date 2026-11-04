/**
 * Firefox Android often never exposes redirect URLs to tabs.onUpdated.
 * This runs on the hosted OAuth callback page and hands the URL to background.
 */
(function () {
  const url = String(location.href || "");
  if (!/[?&](?:code|error)=/.test(url))
    return;

  try {
    chrome.runtime.sendMessage({ type: "oauthCallback", url }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* extension gone */
  }
})();
