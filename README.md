# Outfit Viewer

A SillyTavern extension that shows an outfit image in a panel to the right of the chat. It switches automatically when an outfit's name is mentioned, and you can pick one by hand at any time. It isn't tied to any character card.

## Setup

1. Put all your outfit images in one folder.
2. Open Extensions → Outfit Viewer → **Choose outfit folder** and select that folder.
3. On Chrome/Edge the folder is remembered. After a browser restart you may need to click **Reconnect folder** once. On Firefox you pick the folder again each session.

## Outfit names

- An image's outfit name is its filename without the extension: `Witch.png` → "Witch".
- Several keys can share one image, separated by commas: `Fluffy witch, Paw witch.png` is shown as "Fluffy witch" and switches on either phrase.
- Files still carrying an image generator's long automatic name (containing "masterpiece", or starting with a long number) are named from the prompt stored in the PNG instead. The first word or two after the style tags becomes the name, e.g. `**Witch <weight[1.1]:cosplay>.**` → "Witch".
- If two images end up with the same name, the second becomes "Name 2", and so on. Rename a file to give it a proper name.

## Switching

- Whenever a message mentions an outfit name as a whole word (case-insensitive), the panel switches to it. If several are mentioned, the last one wins, and longer names beat shorter ones at the same spot, so "Fluffy witch" beats "witch".
- The dropdown at the top of the panel picks an outfit by hand.
- With the mouse over the panel, the scroll wheel or the left/right arrow keys flip to the previous/next outfit.
- Drag the panel by its header (the grip icon) to move it; double-click the header to put it back in the top-right corner.
- `/outfit Name` shows an outfit; `/outfit` with no name clears it.
- The current outfit is saved per chat.
