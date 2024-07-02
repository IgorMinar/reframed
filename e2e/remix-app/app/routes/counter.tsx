import { useState } from "react";

export default function Counter() {
  const [counter, setCounter] = useState(0);

  return (
    <>
      <div>
        <style>{`
    .counter {
        margin: 1rem;
        display: flex;
        gap: 1rem;
        width: 15rem;
        background: #e4e4e4;
        justify-content: space-between;
        padding: 0.5rem;
    }
  `}</style>
        <div className="counter">
          <button
            onClick={() => {
              setCounter((counter) => counter - 1);
            }}
          >
            -
          </button>
          <span>{counter}</span>
          <button
            onClick={() => {
              setCounter((counter) => counter + 1);
            }}
          >
            +
          </button>
        </div>
      </div>
    </>
  );
}
