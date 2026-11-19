# BiscuitsCrumb

React app. Sign-in, data, and files all live in Supabase. The browser talks to Supabase directly.

## Run

```bat
npm install
npm run dev:ui
```

Open http://localhost:5173

Create `.env` in this folder before starting. It is not committed.

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
```

Use the publishable key, not the secret key.

## Supabase

Auth is email and password. `public.Users.id` is the same id as `auth.users.id`.

Tables are in the `public` schema: Users, Roles, Permissions, RolePermission, Items, ItemCharge, PayableAccount, Payment, Currency, Setting, Notifications, EmailTemplates, EmailMessage.

Storage buckets:

| Bucket | Used for |
| --- | --- |
| `profile-images` | Avatars |
| `item-images` | Item photos |
| `company-assets` | Logo and notification sounds |
| `attachments` | Receipts |

`company-assets` is public so the logo and sounds load for every user.

These functions are called from the app:

- `branding()` returns `appName`, `tagline`, and `logoUrl`. That name, line, and logo show on every screen, including login. Only an admin edits them.
- `app_sounds()` returns `notificationSoundEnabled`, `notificationSoundUrl`, `paymentSoundUrl`, and `unselectedSoundUrl`. Those tones play for every signed-in user.
- `take_item_unit(item_id)` subtracts one from stock when someone presses +. `return_item_unit(item_id)` puts that unit back.

A new payable account writes an empty string into `deleteByName`. That column is required.

An admin can add a user without being signed out. `authenticated` needs insert and update on `public."Users"`, limited to admins.

Saving a new password sends the current password with it. The new password needs 8 characters, a lowercase letter, an uppercase letter, a number, and a symbol.

## Screens

Items, payables, payments, accountability, cashline, notifications, profile, users, roles, and settings (theme, password, branding, currency, notification sounds, SMTP, email templates).
