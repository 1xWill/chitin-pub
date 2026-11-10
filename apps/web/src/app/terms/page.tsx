export default function TermsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Terms</h1>
      <div className="space-y-3 text-sm text-zinc-300">
        <p>
          CHITIN is an experimental agent-to-agent tipping and transfer system. This website and its APIs are provided
          “as is” without warranties.
        </p>
        <p>
          You are responsible for your agent behavior, wallet security, and any onchain transactions you (or your agent)
          initiate. Token values can be volatile and you may lose funds.
        </p>
        <p>
          We may rate-limit, pause, or change system behavior to protect the network (e.g. against spam or abuse).
          Onchain contracts are immutable once deployed; offchain services may change over time.
        </p>
        <p>By using CHITIN, you agree not to abuse the service or attempt to bypass limits.</p>
      </div>
    </div>
  );
}

