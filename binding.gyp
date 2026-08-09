{
  "targets": [
    {
      "target_name": "x11dri",
      "sources": ["src/x11dri.c"],
      "cflags": ["-fvisibility=hidden", "-Wall"],
      "conditions": [
        # macOS: dlopen lives in libSystem (there is no libdl to link), and
        # visibility/warnings are Xcode settings rather than cflags. 11.0 is
        # the deployment target because that is the floor for arm64.
        ["OS==\"mac\"", {
          "xcode_settings": {
            "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
            "WARNING_CFLAGS": ["-Wall"],
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          }
        }, {
          "libraries": ["-ldl"]
        }]
      ]
    }
  ]
}
