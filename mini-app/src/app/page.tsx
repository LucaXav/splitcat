export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 text-center">
      <div className="text-6xl mb-4">🐱</div>
      <h1 className="text-2xl font-bold mb-2">SplitCat</h1>
      <p className="text-tg-hint max-w-sm">
        This page is meant to open from a Telegram receipt link. Snap a receipt
        in a group chat where SplitCat is added, then tap <b>Assign items</b>.
      </p>
    </main>
  );
}
