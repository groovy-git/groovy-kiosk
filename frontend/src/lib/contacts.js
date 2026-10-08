// Add to contacts: a customer handed to the phone as a contact card.
//
// A web page cannot write into a phone's contacts. What it can do is give the phone a contact card
// (a .vcf file) with the name and number filled in; the phone's own Contacts app opens it and the
// person taps Save.

import { isIPhoneOrIPad, isInstalledApp } from "./print";

export const contactName = (c) => String(c.name || "").trim() || `Customer ${c.phone}`;

// \ , ; and line breaks mean something inside a card, so an odd name is written with them escaped
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\r\n?|\n/g, "\\n").replace(/[,;]/g, "\\$&");

// The whole name goes in as the first name: splitting "Mohammed Abdul Rahman" into first and last is a guess.
export function vcard(c) {
  const name = esc(contactName(c));
  return ["BEGIN:VCARD", "VERSION:3.0", `N:;${name};;;`, `FN:${name}`, `TEL;TYPE=CELL:+91${c.phone}`, "END:VCARD", ""].join("\r\n");
}

// the card's file is named after the customer; a name made only of signs a file name can't hold gets a plain one
export function cardFileName(c) {
  const name = contactName(c).replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "");
  return (name || "contact") + ".vcf";
}

/**
 * Which numbers this phone has been handed already, so the button can say so.
 *
 * It is about the phone's contacts, not about who is logged in, so it stays through a logout. It records
 * the tap, not the save: the app cannot see whether Save was pressed, or what is in the phone's contacts.
 * Kept by number, so a customer whose number is corrected is offered again.
 */
const ADDED_KEY = "gp_contacts_added";
const added = () => {
  try {
    const v = JSON.parse(localStorage.getItem(ADDED_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
export const wasAdded = (phone) => added().includes(String(phone));
const markAdded = (phone) => {
  try {
    localStorage.setItem(ADDED_KEY, JSON.stringify([...new Set([...added(), String(phone)])]));
  } catch {
    /* storage full / private mode — the card is still handed over */
  }
};

// No byte-order mark in front, unlike our CSV files: a phone reads a card only if it starts with BEGIN:VCARD.
function downloadCard(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/vcard;charset=utf-8" }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // kept a minute: a phone may ask "download again?" before it starts
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 60000);
}

/**
 * Hands the card to the phone. True when it went, false when the person closed the iPhone's sheet
 * without choosing; throws with a message for the person when this phone has no way to take it.
 *
 * Android and computers: a download, which the Contacts app opens.
 *
 * iPhone and iPad: the share sheet, where Contacts is one of the apps offered. It lies over the app and
 * closes back onto it. Sending the app's own window to the card is not safe there: the installed app has
 * no Back button, and iPhones have left such apps on a blank page.
 */
export async function addToContacts(c) {
  const filename = cardFileName(c);
  const text = vcard(c);
  if (isIPhoneOrIPad()) {
    const file = new File([text], filename, { type: "text/vcard" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (e) {
        if (e.name === "AbortError") return false;
        throw new Error("Could not open the share sheet. Please try again.");
      }
      markAdded(c.phone);
      return true;
    }
    // an older iPhone that cannot share a file: its browser can still download the card, the installed app cannot
    if (isInstalledApp()) throw new Error("To add contacts on this iPhone, open Groovy Kiosk in Safari.");
  }
  downloadCard(filename, text);
  markAdded(c.phone);
  return true;
}
