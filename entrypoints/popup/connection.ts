type ConnectionReply = { ok: boolean; error?: string; confirmationRequired?: boolean };
export type ConnectionStatus = {
  paired: boolean;
  pairedAccountName?: string;
  pendingPair?: { id: string; accountName: string; expiresAt: string };
  rsiAccount?: { label: string };
  pendingRsiAccount?: { id: string; label: string };
};
type PopupControls = {
  get: <T extends HTMLElement>(id: string) => T;
  show: (message: string, error?: boolean) => void;
  run: (action: () => Promise<void>) => Promise<void>;
  watchImport: () => void;
};

/** Render the isolated approval controls and bind decisions to the reviewed proposals. */
export function bindConnectionControls({ get, show, run, watchImport }: PopupControls) {
  const code = get<HTMLInputElement>('code');
  const pairing = get('pairing');
  const connected = get('connected');
  const form = get<HTMLFormElement>('pair-form');
  const pair = form.querySelector('button')!;
  const confirmPair = get<HTMLButtonElement>('confirm-pair');
  const dismissPair = get<HTMLButtonElement>('dismiss-pair');
  const confirmRsi = get<HTMLButtonElement>('confirm-rsi');
  const dismissRsi = get<HTMLButtonElement>('dismiss-rsi');
  const disconnectCurrent = get<HTMLButtonElement>('disconnect-current');
  const connectionButtons = [
    pair,
    confirmPair,
    dismissPair,
    confirmRsi,
    dismissRsi,
    disconnectCurrent,
  ];
  let reviewedPairId: string | undefined;
  let reviewedRsiId: string | undefined;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      show('Pairing this browser…');
      const result: ConnectionReply = await browser.runtime.sendMessage({
        type: 'exchangeCode',
        code: code.value.trim(),
      });
      if (!result?.ok) {
        const message =
          result?.error === 'network_error'
            ? 'Could not reach Citizen Hangar. Try again.'
            : result?.error === 'extension_disabled'
              ? 'Pairing is temporarily unavailable. Try again later.'
              : result?.error === 'invalid_dashboard'
                ? 'Open the Dashboard to pair this browser.'
                : 'That code is invalid, expired, or already used. Get a fresh code from the Dashboard.';
        show(message, true);
        code.select();
        return;
      }
      form.reset();
      show(
        result.confirmationRequired
          ? 'Review the Dashboard account and approve pairing.'
          : 'Browser paired. Select Sync now to review your RSI account.',
      );
    });
  });

  // Send the identifier rendered in the popup. The worker checks that the
  // reviewed proposal is still current before applying an approval.
  confirmPair.addEventListener(
    'click',
    () =>
      void run(async () => {
        if (!reviewedPairId) return;
        const result: ConnectionReply = await browser.runtime.sendMessage({
          type: 'confirm-pair',
          id: reviewedPairId,
        });
        show(
          result?.ok
            ? 'Browser paired. Select Sync now to review your RSI account.'
            : 'Could not approve this pairing. Review any pending request or get a fresh code.',
          !result?.ok,
        );
      }),
  );

  dismissPair.addEventListener(
    'click',
    () =>
      void run(async () => {
        if (!reviewedPairId) return;
        const result: ConnectionReply = await browser.runtime.sendMessage({
          type: 'dismiss-pair',
          id: reviewedPairId,
        });
        show(result?.ok ? 'Pairing declined.' : 'The pairing request has changed.', !result?.ok);
      }),
  );

  confirmRsi.addEventListener(
    'click',
    () =>
      void run(async () => {
        if (!reviewedRsiId) return;
        const result: ConnectionReply = await browser.runtime.sendMessage({
          type: 'confirm-rsi-account',
          id: reviewedRsiId,
        });
        if (!result?.ok) {
          show(
            'The active RSI account could not be confirmed. Check your RSI sign-in and try again.',
            true,
          );
          return;
        }
        show('RSI account approved. Preparing your import…');
        watchImport();
      }),
  );

  dismissRsi.addEventListener(
    'click',
    () =>
      void run(async () => {
        if (!reviewedRsiId) return;
        const result: ConnectionReply = await browser.runtime.sendMessage({
          type: 'dismiss-rsi-account',
          id: reviewedRsiId,
        });
        show(
          result?.ok ? 'RSI account declined.' : 'The RSI account request has changed.',
          !result?.ok,
        );
      }),
  );

  disconnectCurrent.addEventListener(
    'click',
    () =>
      void run(async () => {
        const result: ConnectionReply = await browser.runtime.sendMessage({
          type: 'disconnect-current',
        });
        if (result?.ok) get<HTMLDetailsElement>('disconnect-options').open = false;
        show(
          result?.ok
            ? 'This browser was disconnected.'
            : 'Could not disconnect this browser. Try again.',
          !result?.ok,
        );
      }),
  );

  return {
    render(status: ConnectionStatus) {
      reviewedPairId = status.pendingPair?.id;
      reviewedRsiId = status.pendingRsiAccount?.id;
      get('pair-confirmation').hidden = !reviewedPairId;
      get('pending-account').textContent = status.pendingPair?.accountName || '';
      get('rsi-confirmation').hidden = !reviewedRsiId;
      get('pending-rsi-account').textContent = status.pendingRsiAccount?.label || '';
      get('paired-account').textContent = status.pairedAccountName || 'Unavailable';
      get('approved-rsi-account').textContent = status.rsiAccount?.label || 'Awaiting approval';
      pairing.hidden = status.paired || Boolean(reviewedPairId);
      connected.hidden = !status.paired;

      return Boolean(reviewedRsiId);
    },
    setBusy(busy: boolean) {
      for (const button of connectionButtons) button.disabled = busy;
    },
  };
}
