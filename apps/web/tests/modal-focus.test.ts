import assert from "node:assert/strict";
import { after, test } from "node:test";
import { activateModalFocus } from "../app/lib/modal-focus.ts";

const originals = new Map(["document","HTMLElement"].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
after(() => { for (const [key,value] of originals) { if(value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key); } });

// Simulate the browser focus boundary without a server, network, or DOM library.
class FocusDocument extends EventTarget { activeElement: FocusElement | null = null; }
class FocusElement {
  isConnected = true;
  hidden = false;
  disabled = false;
  inert = false;
  entries: FocusElement[] = [];
  readonly owner: FocusDocument;
  constructor(owner:FocusDocument) { this.owner = owner; }
  focus() { this.owner.activeElement = this; const event = new Event("focusin"); Object.defineProperty(event,"target",{value:this}); this.owner.dispatchEvent(event); }
  contains(value:unknown) { return value === this || this.entries.includes(value as FocusElement); }
  querySelectorAll() { return this.entries.filter(entry => !entry.disabled); }
  closest() { return this.inert ? this : null; }
}
function key(document:FocusDocument,name:string,shiftKey=false) {
  const event = new Event("keydown",{cancelable:true});
  Object.defineProperties(event,{key:{value:name},shiftKey:{value:shiftKey}});
  document.dispatchEvent(event);
  return event;
}

test("a modal receives focus, cycles live controls, handles Escape and restores its opener", () => {
  const document = new FocusDocument();
  Object.defineProperty(globalThis,"document",{configurable:true,value:document});
  Object.defineProperty(globalThis,"HTMLElement",{configurable:true,value:FocusElement});
  const opener = new FocusElement(document), dialog = new FocusElement(document);
  const close = new FocusElement(document), download = new FocusElement(document), share = new FocusElement(document);
  const hidden = new FocusElement(document), disabled = new FocusElement(document), inert = new FocusElement(document);
  hidden.hidden = true; disabled.disabled = true; inert.inert = true;
  dialog.entries = [close,hidden,disabled,inert,download,share];
  opener.focus();
  let closures = 0;
  const release = activateModalFocus(dialog as unknown as HTMLElement,close as unknown as HTMLElement,() => { closures++; });
  assert.equal(document.activeElement,close,"initial focus moves into the modal");
  assert.equal(key(document,"Tab").defaultPrevented,true);
  assert.equal(document.activeElement,download,"unusable controls do not enter the cycle");
  key(document,"Tab"); assert.equal(document.activeElement,share);
  key(document,"Tab"); assert.equal(document.activeElement,close,"Tab wraps at the last control");
  key(document,"Tab",true); assert.equal(document.activeElement,share,"Shift+Tab wraps at the first control");
  dialog.entries = [close,download];
  close.focus(); key(document,"Tab"); assert.equal(document.activeElement,download,"a changed set of controls is observed");
  const outside = new FocusElement(document); outside.focus();
  assert.equal(document.activeElement,close,"focus cannot escape behind the modal");
  assert.equal(key(document,"Escape").defaultPrevented,true);
  assert.equal(closures,1);
  release();
  assert.equal(document.activeElement,opener,"closing restores the opener");
  assert.equal(key(document,"Escape").defaultPrevented,false);
  assert.equal(closures,1,"cleanup removes the Escape listener");
  outside.focus(); assert.equal(document.activeElement,outside,"cleanup releases the focus constraint");
});
