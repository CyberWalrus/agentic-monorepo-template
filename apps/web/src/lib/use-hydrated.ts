import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/** false во время SSR и гидратации, true после неё. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
