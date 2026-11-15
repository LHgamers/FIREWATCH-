import Link from "next/link";

export default function NotFound() {
  return (
    <div className="panel mx-auto mt-10 max-w-lg p-8 text-center">
      <p className="kicker">Signal lost</p>
      <h1 className="mt-2 text-[22px] font-semibold text-ink">This coordinate does not exist</h1>
      <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
        The page you asked for is not part of the mission. Return to the overview, or open the
        fire map to keep exploring the satellite record.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Link href="/" className="btn btn-primary">Dashboard</Link>
        <Link href="/map" className="btn">Fire map</Link>
      </div>
    </div>
  );
}
