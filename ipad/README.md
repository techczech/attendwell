# AttendWell for iPad: source

This folder holds the source of the AttendWell door app for iPad. It is the app participants tap their name on at a workshop; it pairs with the AttendWell organiser app for Mac.

There is no official App Store listing or TestFlight build of this app. If you want to use it, a developer builds it and installs it on iPads independently:

1. Build and test it with Xcode as described in [iPad/README.md](iPad/README.md).
2. Change the development team and the bundle identifier (`net.dominiklukes.attendwell.ipad`) in the Xcode project to your own, because the committed settings belong to the author's Apple developer account.
3. Run it on your own iPad, or distribute it yourself through TestFlight or an App Store listing under your own account.

The app is MIT licensed, like the rest of the repository. The pairing interface between the iPad and the organiser app is documented in [contract/device-v1](contract/device-v1) and [../docs/reference-device-api.md](../docs/reference-device-api.md).
