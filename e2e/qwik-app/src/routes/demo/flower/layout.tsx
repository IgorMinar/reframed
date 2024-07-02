import { component$, useStylesScoped$, Slot } from "@builder.io/qwik";
import styles from "./flower.css?inline";
import { Link } from "@builder.io/qwik-city";

export default component$(() => {
  useStylesScoped$(styles);

  return (
    <div>
      <nav>
        <ul>
          {["red", "green", "blue"].map((color) => (
            <li key={color}>
              <Link href={`/demo/flower/${color}`}>{color}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <Slot />
    </div>
  );
});
