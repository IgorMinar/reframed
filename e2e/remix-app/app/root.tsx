import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  json,
  useRouteLoaderData,
} from "@remix-run/react";
import { useRef, useState, useEffect } from "react";
import "./tailwind.css";

function isDocumentRequest(request: Request) {
  return request.headers.get('sec-fetch-dest') === 'document';
}

export async function loader({ request }: LoaderFunctionArgs) {
  return json({
    // If the request came from a direct navigation to the app (a document request)
    // the app must be running standalone (e.g. in local dev) so we should serve a full html document.
    // Otherwise, we should just serve a fragment that will be rendered inside of another host application.
    standaloneMode: isDocumentRequest(request),
  });
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [shouldReframe, setShouldReframe] = useState(false);
  const {standaloneMode} = useRouteLoaderData<typeof loader>('root');

  const ref = useRef<HTMLElement>(null);
  const reframingWasTriggered = useRef<boolean>(false);

  useEffect(() => {
    (async () => {
      if (!document.unreframedBody) {
        setShouldReframe(true);
      }

      if(reframingWasTriggered.current) return;
      reframingWasTriggered.current = true;

      const { reframed } = await import("reframed");
      const reframedContainer = ref.current;
      if (!reframedContainer) return;

      await reframed("/counter", { container: reframedContainer });
    })();
  }, []);

  return standaloneMode ? (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
      {shouldReframe && (
        <article
          style={{
            border: "6px dashed red",
            scale: "60%",
            display: "grid",
            placeContent: "center",
          }}
          ref={shouldReframe ? ref : undefined}
        ></article>
      )}
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  ) : (
    <div>
      <Meta />
      <Links />
      {children}
      <ScrollRestoration />
      <Scripts />

      {/*
          This is a hack to work around an issue with WritableDOM not populating
          the contents of the last script element (which just so happens to be responsible
          for hydrating the application). We noticed that if that script tag wasn't the last
          child of the body, its contents were inserted correctly. We're adding this empty
          div here to make the script tag before it no longer be the last child.
        */}
      <div />
    </div>
  );
}

export default function App() {
  return <Outlet />;
}
