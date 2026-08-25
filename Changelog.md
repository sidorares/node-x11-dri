# Changelog

## [0.6.0](https://github.com/sidorares/node-x11-dri/compare/v0.5.0...v0.6.0) (2026-08-25)


### Features

* **apple:** expose the display refresh rate — XQuartz RandR has no timing data ([#15](https://github.com/sidorares/node-x11-dri/issues/15)) ([2471d9c](https://github.com/sidorares/node-x11-dri/commit/2471d9cedd173d66a7cd841e56c8645a44344cfc)), closes [#14](https://github.com/sidorares/node-x11-dri/issues/14)

## [0.5.0](https://github.com/sidorares/node-x11-dri/compare/v0.4.0...v0.5.0) (2026-08-24)


### Features

* accelerated rendering on macOS/XQuartz via Apple-DRI (dri.apple) + cross-platform GL area integration map ([#12](https://github.com/sidorares/node-x11-dri/issues/12)) ([58edf3b](https://github.com/sidorares/node-x11-dri/commit/58edf3bb33fe08b3e7863d24850b567845dbbe0c))

## [0.4.0](https://github.com/sidorares/node-x11-dri/compare/v0.3.0...v0.4.0) (2026-08-09)


### Features

* **gl:** 3D textures, array textures and immutable storage ([0dee228](https://github.com/sidorares/node-x11-dri/commit/0dee228e25329a0d4f849049254f1603a0ce35c1))
* **gl:** program introspection and compressed texture uploads ([dfb8f72](https://github.com/sidorares/node-x11-dri/commit/dfb8f72e84e0748456d12a6b962f79ddf8ec1ad6))
* **gl:** request an ES 3.0 context, falling back to ES 2.0 ([bcafd63](https://github.com/sidorares/node-x11-dri/commit/bcafd635ea25761ca81f04bbce4c6a3470fab7df))
* **gl:** vertex array objects, instancing and multiple render targets ([023422d](https://github.com/sidorares/node-x11-dri/commit/023422dd72933cbf9155ba6e76f5107a6dc62235))
* ship TypeScript declarations ([#11](https://github.com/sidorares/node-x11-dri/issues/11)) ([16c6e5c](https://github.com/sidorares/node-x11-dri/commit/16c6e5c2b96269f6f69f636c51570dd0c93b5458))

## [0.3.0](https://github.com/sidorares/node-x11-dri/compare/v0.2.0...v0.3.0) (2026-08-09)


### Features

* **gl:** textures, blending, framebuffer objects and the uniform family ([687abf9](https://github.com/sidorares/node-x11-dri/commit/687abf9a7bf0901225d9cd5c1b95fcdadf2c3453))

## [0.2.0](https://github.com/sidorares/node-x11-dri/compare/v0.1.0...v0.2.0) (2026-08-09)


### Features

* build for macOS on Apple Silicon ([92fc86f](https://github.com/sidorares/node-x11-dri/commit/92fc86fac741c189bdc873c9484e1abf440e3405))
* build for macOS on Apple Silicon ([0e8de2d](https://github.com/sidorares/node-x11-dri/commit/0e8de2d0548956ffa6621652a59f721d8c5c5cbd))

## 0.1.0 (2026-08-09)


### Features

* bundle prebuilt binaries so npm install needs no toolchain ([92624a0](https://github.com/sidorares/node-x11-dri/commit/92624a0dda477475ca53cc583d5ec4ce41a930e7))
* OpenGL ES + dma-buf native companion for node-x11's DRI3 path ([2a4c22c](https://github.com/sidorares/node-x11-dri/commit/2a4c22c796151109a1312e55d91ce75e078bec38))
