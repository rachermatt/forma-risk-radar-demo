export default function Loading() {
  return (
    <div className="loading-shell" aria-busy="true" aria-live="polite" aria-label="Loading risk intelligence">
      <aside className="loading-shell__sidebar" aria-hidden="true" />
      <main className="loading-shell__main">
        <span className="sr-only">Loading risk intelligence dashboard.</span>
        <div className="loading-shell__bar" aria-hidden="true" />
        <div className="loading-shell__grid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => <span className="loading-shell__card" key={index} />)}
        </div>
      </main>
    </div>
  );
}
