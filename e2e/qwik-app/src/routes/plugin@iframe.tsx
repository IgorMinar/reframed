import type { RequestHandler } from "@builder.io/qwik-city";

/**
 * This is a Qwik middleware plugin that intercepts all http
 * requests from an iframe and returns an empty html response.
 *
 * This is done to enable setting iframe.src in reframed,
 * so that window.location (which is unpatchable and can't
 * be modified without triggering an undesirable iframe
 * reload) in the reframed context has the correct url.
 */
export const onRequest: RequestHandler = async (requestEvent) => {
  if (requestEvent.request.headers.get("sec-fetch-dest") === "iframe") {
    throw requestEvent.html(200, "<!doctype html><title>");
  }
};