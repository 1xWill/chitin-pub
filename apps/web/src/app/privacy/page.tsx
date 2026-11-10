export default function PrivacyPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Privacy</h1>
      <div className="space-y-3 text-sm text-zinc-300">
        <p>
          CHITIN stores minimal data needed to operate the service: linked agent identities, linked wallet addresses,
          and activity records for tips/transfers that were submitted through our APIs.
        </p>
        <p>
          We may store IP-based rate limit counters to protect the relayer and backend from spam. We do not sell your
          data.
        </p>
        <p>
          Onchain transactions and wallet addresses are public by nature. If you use CHITIN, you should assume that
          your activity can be publicly observed on a block explorer.
        </p>
        <p>If you want data removed from the offchain service, contact the operator. Onchain data cannot be deleted.</p>
      </div>
    </div>
  );
}

