#!/bin/bash -e

./make.py build
npx tfx-cli extension create
npx tfx-cli extension publish --token $(cat .auth)
