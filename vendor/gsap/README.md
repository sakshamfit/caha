# GSAP

`gsap.min.js` and `ScrollTrigger.min.js` are copied unmodified from the
`dist/` folder of the `gsap@3.15.0` npm package, the same version the
reference project (alagappan567/cafe-3d-scroll) depends on. They are
vendored so the site stays a no-build static folder that works offline and on
any static host.

GSAP is free to use under the GreenSock "Standard No Charge" license:
https://gsap.com/standard-license (see the header of each file).

To upgrade:

    npm pack gsap@<version> && tar xzf gsap-<version>.tgz
    cp package/dist/gsap.min.js package/dist/ScrollTrigger.min.js vendor/gsap/
