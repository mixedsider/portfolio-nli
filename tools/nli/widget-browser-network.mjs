const gatewayEndpoint = "https://portfolio-nli-gateway.mixedsider.cloud/api/nli";
const fontOrigins = new Set(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);

export async function installWidgetBrowserNetwork(context, { staticUrl, onGatewayRequest }) {
  if (typeof onGatewayRequest !== "function") throw new Error("Widget browser network policy requires a gateway stub.");

  const staticOrigin = new URL(staticUrl).origin;
  const unexpectedRequests = [];
  const blockedFonts = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url === gatewayEndpoint) {
      await onGatewayRequest(route);
      return;
    }

    const origin = new URL(url).origin;
    if (origin === staticOrigin) {
      await route.continue();
      return;
    }

    const record = { url, resourceType: request.resourceType() };
    if (record.resourceType === "font" || fontOrigins.has(origin)) {
      blockedFonts.push(record);
      await route.abort("blockedbyclient");
      return;
    }

    unexpectedRequests.push(record);
    await route.abort("blockedbyclient");
  });

  return {
    unexpectedRequests,
    blockedFonts,
    assertNoUnexpectedRequests() {
      if (unexpectedRequests.length) {
        throw new Error(`Unexpected browser destination: ${unexpectedRequests.map((request) => request.url).join(", ")}`);
      }
    }
  };
}
