# Changelog

## [0.9.0](https://github.com/sidorares/node-x11-dri/compare/v0.8.1...v0.9.0) (2026-09-13)


### Features

* **unixsock:** a unix socket that passes descriptors, on the event loop ([#32](https://github.com/sidorares/node-x11-dri/issues/32)) ([d35b9e6](https://github.com/sidorares/node-x11-dri/commit/d35b9e600edd9836910b3d7db4eb1d74419093cf))

## [0.8.1](https://github.com/sidorares/node-x11-dri/compare/v0.8.0...v0.8.1) (2026-09-12)


### Bug Fixes

* **dmabuf:** map read-only descriptors, and let only the importing context destroy an image ([#30](https://github.com/sidorares/node-x11-dri/issues/30)) ([2652706](https://github.com/sidorares/node-x11-dri/commit/26527069286973e9cc0cf551d4580313ac7a5a6a))

## [0.8.0](https://github.com/sidorares/node-x11-dri/compare/v0.7.0...v0.8.0) (2026-09-12)


### Features

* **gl:** separate stencil state, multisampling, sync objects and GPU timer queries ([#23](https://github.com/sidorares/node-x11-dri/issues/23)) ([1c63c52](https://github.com/sidorares/node-x11-dri/commit/1c63c521e8b6269f63b48b43f4f473c93f214fb6))
* **gpu:** stencilSize on GpuOptions, and the granted bits read back ([#25](https://github.com/sidorares/node-x11-dri/issues/25)) ([c41cf3a](https://github.com/sidorares/node-x11-dri/commit/c41cf3a457cea5f750248bdc2a6299f63ddbcbf6))
* import a dma-buf as a GL texture, and map one for the CPU ([#18](https://github.com/sidorares/node-x11-dri/issues/18)) ([e97acc0](https://github.com/sidorares/node-x11-dri/commit/e97acc0a6087150d4ed2f6eb053d6e3cce8d6243)), closes [#17](https://github.com/sidorares/node-x11-dri/issues/17)
* **surface:** resize the swapchain in place, and namespace keys by generation ([#26](https://github.com/sidorares/node-x11-dri/issues/26)) ([ff06886](https://github.com/sidorares/node-x11-dri/commit/ff06886fad3cb2dee98747a975efab84a5fa501c)), closes [#20](https://github.com/sidorares/node-x11-dri/issues/20)


### Bug Fixes

* **gpu:** close the render node when the Gpu constructor throws ([#28](https://github.com/sidorares/node-x11-dri/issues/28)) ([86ffe32](https://github.com/sidorares/node-x11-dri/commit/86ffe3245f3f51b5f028f4ab429361eb8c65b16e))

## [0.7.0](https://github.com/sidorares/node-x11-dri/compare/v0.6.0...v0.7.0) (2026-09-01)


### Features

* **apple:** IOSurface render targets for compositor-less presentation ([#21](https://github.com/sidorares/node-x11-dri/issues/21)) ([1921adc](https://github.com/sidorares/node-x11-dri/commit/1921adcee9d7282633d89ad7992fe3a9348239df))

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
