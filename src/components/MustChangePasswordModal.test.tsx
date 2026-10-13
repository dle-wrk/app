import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MustChangePasswordModal from './MustChangePasswordModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const fillNew = async (pw: string) => {
  const [a, b] = [...host.querySelectorAll('input[autocomplete="new-password"]')] as HTMLInputElement[];
  await act(async () => { setValue(a, pw); setValue(b, pw); });
};
const submit = async () => {
  await act(async () => { (host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};

describe('the forced password change after a reset', () => {
  it("uses the password just signed in with: no current-password box for a browser to fill", async () => {
    const onSubmit = vi.fn(async () => {});
    await act(async () => { root.render(<MustChangePasswordModal currentPassword="Temp1234abcd" onSubmit={onSubmit} onSignOut={() => {}} />); });
    expect(host.querySelector('input[autocomplete="current-password"]')).toBeNull();
    expect(host.querySelector('[data-testid="current-from-sign-in"]')).not.toBeNull();
    await fillNew('a-new-password-1');
    await submit();
    expect(onSubmit).toHaveBeenCalledWith('Temp1234abcd', 'a-new-password-1');
  });

  it('can be typed instead, and asks for it when it is not known (after a reload)', async () => {
    const onSubmit = vi.fn(async () => {});
    await act(async () => { root.render(<MustChangePasswordModal currentPassword="Temp1234abcd" onSubmit={onSubmit} onSignOut={() => {}} />); });
    const typeIt = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Type it instead')!;
    await act(async () => { typeIt.click(); });
    const current = host.querySelector('input[autocomplete="current-password"]') as HTMLInputElement;
    expect(current.value).toBe('');

    await act(async () => { root.render(<MustChangePasswordModal key="reload" onSubmit={onSubmit} onSignOut={() => {}} />); });
    expect(host.querySelector('input[autocomplete="current-password"]')).not.toBeNull();
  });
});
