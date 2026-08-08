{
  "targets": [
    {
      "target_name": "x11dri",
      "sources": ["src/x11dri.c"],
      "cflags": ["-fvisibility=hidden", "-Wall"],
      "libraries": ["-ldl"]
    }
  ]
}
