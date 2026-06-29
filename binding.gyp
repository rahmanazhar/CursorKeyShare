{
  "targets": [
    {
      "target_name": "cursorkeyshare-native",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "sources": ["native/input.cc"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["native/input_win.cc"],
          "libraries": ["-lUser32"],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1 }
          }
        }],
        ["OS=='mac'", {
          "sources": ["native/input_mac.mm"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_CPLUSPLUSFLAGS": ["-ObjC++"]
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/ApplicationServices.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreGraphics.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreFoundation.framework"
            ]
          }
        }]
      ]
    }
  ]
}
