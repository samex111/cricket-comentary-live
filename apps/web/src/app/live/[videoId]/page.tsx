import { LivePlayer } from "@/components/live-player";

export default async function LivePlaybackPage({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  return <main className="min-h-screen bg-[#090909] px-4 py-8 text-white md:px-8">
    <div className="mx-auto max-w-6xl space-y-6">
      <a href="/" className="text-xs text-neutral-500 hover:text-white">← Back to Boundary Studio</a>
      <div><p className="text-xs tracking-[.2em] text-neutral-500">BOUNDARY / LIVE</p><h1 className="mt-2 text-2xl font-semibold">Playback-synchronized AI commentary</h1></div>
      <LivePlayer videoId={videoId} title="Cricket match playback" />
    </div>
  </main>;
}
